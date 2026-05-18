// Vertical drag handle used between the workspace sidebar / main pane and
// between the main pane / inspector. Identical visuals + behaviour, only
// the side (`"sidebar"` vs `"inspector"`) and offset rules differ.
import type { CSSProperties, KeyboardEvent, MouseEvent } from "react";
import { cn } from "@/lib/utils";
import {
	MAX_SIDEBAR_WIDTH,
	MIN_SIDEBAR_WIDTH,
	SIDEBAR_RESIZE_HIT_AREA,
} from "@/shell/layout";

type Props = {
	side: "sidebar" | "inspector";
	collapsed: boolean;
	resizing: boolean;
	width: number;
	onMouseDown: (event: MouseEvent<HTMLDivElement>) => void;
	onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
};

export function ShellResizeSeparator({
	side,
	collapsed,
	resizing,
	width,
	onMouseDown,
	onKeyDown,
}: Props) {
	const containerStyle: CSSProperties =
		side === "sidebar"
			? {
					left: collapsed
						? `${-SIDEBAR_RESIZE_HIT_AREA / 2}px`
						: `${width - SIDEBAR_RESIZE_HIT_AREA / 2}px`,
					width: `${SIDEBAR_RESIZE_HIT_AREA}px`,
				}
			: {
					right: collapsed
						? `${-SIDEBAR_RESIZE_HIT_AREA}px`
						: `${Math.max(0, width - SIDEBAR_RESIZE_HIT_AREA)}px`,
					width: `${SIDEBAR_RESIZE_HIT_AREA}px`,
				};

	const transitionAxis = side === "sidebar" ? "left" : "right";
	const handleClass =
		side === "sidebar"
			? "absolute inset-y-0 left-1/2 -translate-x-1/2"
			: "absolute inset-y-0 left-0";

	return (
		<div
			role="separator"
			tabIndex={collapsed ? -1 : 0}
			aria-hidden={collapsed}
			aria-label={`Resize ${side === "sidebar" ? "sidebar" : "inspector sidebar"}`}
			aria-orientation="vertical"
			aria-valuemin={MIN_SIDEBAR_WIDTH}
			aria-valuemax={MAX_SIDEBAR_WIDTH}
			aria-valuenow={width}
			onMouseDown={onMouseDown}
			onKeyDown={onKeyDown}
			className={cn(
				"group absolute inset-y-0 z-30 cursor-ew-resize touch-none outline-none",
				resizing
					? "transition-none"
					: `transition-[${transitionAxis},opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]`,
				collapsed ? "pointer-events-none opacity-0" : "opacity-100",
			)}
			style={containerStyle}
		>
			<span
				aria-hidden="true"
				className={cn(
					"pointer-events-none transition-[width,background-color,box-shadow]",
					handleClass,
					resizing
						? "w-[2px] bg-foreground/80 shadow-[0_0_12px_rgba(0,0,0,0.12)] dark:shadow-[0_0_12px_rgba(255,255,255,0.16)]"
						: "w-px bg-border group-hover:w-[2px] group-hover:bg-muted-foreground/75 group-focus-visible:w-[2px] group-focus-visible:bg-muted-foreground/75",
				)}
			/>
		</div>
	);
}
