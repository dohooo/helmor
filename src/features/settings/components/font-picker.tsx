import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/// Free-form font input. Codex-style: a single text field whose
/// placeholder shows the currently rendered font stack so the user knows
/// what they're overriding without us having to enumerate system fonts.
/// Empty input on commit (blur / Enter) clears the override (= null).
export type FontPickerProps = {
	value: string | null;
	onChange: (next: string | null) => void;
	/** Effective CSS font-family used when value is null. */
	effectivePlaceholder: string;
	className?: string;
	ariaLabel?: string;
};

export function FontPicker({
	value,
	onChange,
	effectivePlaceholder,
	className,
	ariaLabel,
}: FontPickerProps) {
	const [local, setLocal] = useState(value ?? "");

	useEffect(() => {
		setLocal(value ?? "");
	}, [value]);

	function commit(next: string) {
		const trimmed = next.trim();
		onChange(trimmed.length === 0 ? null : trimmed);
	}

	return (
		<Input
			value={local}
			onChange={(e) => setLocal(e.target.value)}
			onBlur={() => commit(local)}
			onKeyDown={(e) => {
				if (e.key === "Enter") {
					(e.target as HTMLInputElement).blur();
				} else if (e.key === "Escape") {
					setLocal(value ?? "");
					(e.target as HTMLInputElement).blur();
				}
			}}
			placeholder={effectivePlaceholder}
			aria-label={ariaLabel}
			className={cn(
				"h-7 w-48 px-2 py-0 font-mono text-[10px] md:text-[10px]",
				className,
			)}
			spellCheck={false}
		/>
	);
}
