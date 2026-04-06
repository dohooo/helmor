import {
	ArrowBigUp,
	Command,
	CornerDownLeft,
	Delete,
	Option,
	Space,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { cn } from "@/lib/utils";

/**
 * Maps well-known key names to their lucide-react icon.
 * Keys not listed here fall through to the text-in-box rendering.
 */
const ICON_MAP: Record<
	string,
	ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>
> = {
	shift: ArrowBigUp,
	command: Command,
	cmd: Command,
	"⌘": Command,
	option: Option,
	alt: Option,
	"⌥": Option,
	enter: CornerDownLeft,
	return: CornerDownLeft,
	"⏎": CornerDownLeft,
	delete: Delete,
	"⌫": Delete,
	space: Space,
};

type KbdKeyProps = {
	/** The key name — e.g. "Esc", "Shift", "⌘", "Enter", "A" */
	name: string;
	className?: string;
};

export function KbdKey({ name, className }: KbdKeyProps) {
	const Icon = ICON_MAP[name.toLowerCase()];

	return (
		<kbd
			data-slot="kbd"
			className={cn(
				"inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-[2px] border border-white/25 px-0.5 text-[9px] font-medium leading-none text-white/70",
				className,
			)}
		>
			{Icon ? (
				<Icon className="size-2.5" strokeWidth={1.8} />
			) : (
				<span>{name}</span>
			)}
		</kbd>
	);
}
