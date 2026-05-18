import { KbdKey } from "@/components/ui/kbd-key";
import { cn } from "@/lib/utils";
import { shortcutToInlineParts, shortcutToKeys } from "./format";

type ShortcutDisplayProps = {
	hotkey: string | null;
	emptyLabel?: string;
	className?: string;
	emptyClassName?: string;
	keyClassName?: string;
};

export function ShortcutDisplay({
	hotkey,
	emptyLabel = "---",
	className,
	emptyClassName,
	keyClassName,
}: ShortcutDisplayProps) {
	const keys = shortcutToKeys(hotkey);

	if (keys.length === 0) {
		return (
			<span
				aria-hidden="true"
				className={cn(
					"inline-flex h-5 items-center px-2 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground",
					className,
					emptyClassName,
				)}
			>
				{emptyLabel}
			</span>
		);
	}

	return (
		<span
			aria-hidden="true"
			className={cn("inline-flex items-center gap-1", className)}
		>
			{keys.map((key, index) => (
				<KbdKey
					key={`${key}-${index}`}
					name={key}
					className={cn(
						"h-5 min-w-5 rounded-[4px] border-border/70 bg-background px-1.5 text-[11px] text-muted-foreground shadow-[inset_0_-1px_0_rgba(0,0,0,0.08)] dark:border-white/15 dark:bg-white/5 dark:text-white/70",
						keyClassName,
					)}
				/>
			))}
		</span>
	);
}

type InlineShortcutDisplayProps = {
	hotkey: string | null;
	className?: string;
};

export function InlineShortcutDisplay({
	hotkey,
	className,
}: InlineShortcutDisplayProps) {
	const parts = shortcutToInlineParts(hotkey);
	if (parts.length === 0) return null;

	return (
		<span
			aria-hidden="true"
			className={cn(
				"inline-flex items-center gap-px font-medium leading-none tracking-normal text-current",
				className,
			)}
		>
			{parts.map((part, index) => (
				<span
					key={`${part}-${index}`}
					className={cn(
						"inline-flex items-center justify-center",
						part.length === 1 &&
							!/[⌘⌥⌃⇧]/.test(part) &&
							"min-w-[0.7em] font-[ui-monospace,SF_Mono,SFMono-Regular,Menlo,Monaco,Consolas,monospace]",
					)}
				>
					{part}
				</span>
			))}
		</span>
	);
}
