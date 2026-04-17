import {
	ArrowBigUp,
	Command,
	CornerDownLeft,
	Delete,
	Option,
	Space,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";

type IconComponent = ComponentType<
	SVGProps<SVGSVGElement> & { size?: number | string }
>;

/**
 * Shared icon map for keys that look the same on every OS
 * (shift, enter, delete, space). `command` and `option` vary per OS and are
 * handled separately below.
 */
const SHARED_ICON_MAP: Record<string, IconComponent> = {
	shift: ArrowBigUp,
	enter: CornerDownLeft,
	return: CornerDownLeft,
	"⏎": CornerDownLeft,
	delete: Delete,
	"⌫": Delete,
	space: Space,
};

/**
 * Resolve the rendered representation of a key name.
 * - macOS uses native glyphs (⌘ / ⌥ / ArrowBigUp).
 * - Windows / Linux swap `command` → "Ctrl" text, `option` → "Alt" text so
 *   users see the convention they actually type. Shift stays as the arrow
 *   icon on every platform because it's visually recognizable.
 */
function resolveKey(
	name: string,
): { kind: "icon"; icon: IconComponent } | { kind: "text"; text: string } {
	const lower = name.toLowerCase();
	if (lower === "command" || lower === "cmd" || lower === "⌘") {
		return isMac()
			? { kind: "icon", icon: Command }
			: { kind: "text", text: "Ctrl" };
	}
	if (lower === "option" || lower === "alt" || lower === "⌥") {
		return isMac()
			? { kind: "icon", icon: Option }
			: { kind: "text", text: "Alt" };
	}
	const shared = SHARED_ICON_MAP[lower];
	if (shared) {
		return { kind: "icon", icon: shared };
	}
	return { kind: "text", text: name };
}

type KbdKeyProps = {
	/** The key name — e.g. "Esc", "Shift", "⌘", "Enter", "A" */
	name: string;
	className?: string;
};

export function KbdKey({ name, className }: KbdKeyProps) {
	const resolved = resolveKey(name);

	return (
		<kbd
			data-slot="kbd"
			className={cn(
				"inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-[2px] border border-white/25 px-0.5 text-[9px] font-medium leading-none text-white/70",
				className,
			)}
		>
			{resolved.kind === "icon" ? (
				<resolved.icon className="size-2.5" strokeWidth={1.8} />
			) : (
				<span>{resolved.text}</span>
			)}
		</kbd>
	);
}
