import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/// Shared "value picker" used by settings rows. Mirrors the visual
/// vocabulary established by `ColorThemePicker` / `FontPicker` —
/// outline-Button trigger with a chevron, listbox with check marks —
/// so new settings stay consistent without each row reinventing it.
///
/// For text-only options use this component directly. For rich items
/// (color swatches, font previews, …) extend the API with a
/// `renderItem` slot when a future migration needs it.

export type SettingsSelectOption<V extends string> = {
	value: V;
	label: string;
};

export function SettingsSelect<V extends string>({
	value,
	options,
	onChange,
	disabled = false,
	triggerClassName,
	contentClassName,
	ariaLabel,
}: {
	value: V;
	options: readonly SettingsSelectOption<V>[];
	onChange: (next: V) => void;
	disabled?: boolean;
	/** Override the default `w-[180px]` trigger width. */
	triggerClassName?: string;
	/** Override the default `w-[220px]` listbox width. */
	contentClassName?: string;
	ariaLabel?: string;
}) {
	const [open, setOpen] = useState(false);
	const current = options.find((o) => o.value === value) ?? options[0];

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="outline"
					disabled={disabled}
					aria-label={ariaLabel}
					className={cn(
						"h-8 w-[180px] justify-between gap-2 px-2 text-ui font-normal",
						triggerClassName,
					)}
				>
					<span className="truncate">{current?.label}</span>
					<ChevronDown
						className="size-3.5 shrink-0 text-muted-foreground"
						strokeWidth={1.8}
					/>
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				sideOffset={4}
				className={cn("w-[220px] p-1", contentClassName)}
			>
				<div
					role="listbox"
					className="flex max-h-[320px] flex-col overflow-y-auto"
				>
					{options.map((opt) => {
						const selected = opt.value === value;
						return (
							<button
								key={opt.value}
								type="button"
								role="option"
								aria-selected={selected}
								onClick={() => {
									onChange(opt.value);
									setOpen(false);
								}}
								className={cn(
									"flex h-8 cursor-interactive items-center justify-between gap-2 rounded-md px-2 text-ui text-foreground transition-colors hover:bg-accent",
									selected && "bg-accent/60",
								)}
							>
								<span className="truncate">{opt.label}</span>
								{selected ? (
									<Check
										className="size-3.5 shrink-0 text-muted-foreground"
										strokeWidth={2}
									/>
								) : null}
							</button>
						);
					})}
				</div>
			</PopoverContent>
		</Popover>
	);
}
