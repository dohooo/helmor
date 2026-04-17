import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";

/**
 * Reserves horizontal space for the OS window controls so header content
 * does not overlap them.
 *
 * - macOS: traffic lights sit on the left at (16, 24). `side="left"` renders
 *   the spacer; `side="right"` renders nothing.
 * - Windows / Linux: minimize / maximize / close sit on the right.
 *   `side="right"` renders the spacer; `side="left"` renders nothing.
 *
 * The component is also a drag region (Tauri's `data-tauri-drag-region`)
 * so the reserved area is draggable like the surrounding header.
 */
export function TrafficLightSpacer({
	side,
	width = 86,
	className,
}: {
	side: "left" | "right";
	/** Pixel width to reserve. Defaults to 86, matching existing headers. */
	width?: number;
	className?: string;
}) {
	const mac = isMac();
	const shouldRender = (side === "left" && mac) || (side === "right" && !mac);
	if (!shouldRender) {
		return null;
	}
	return (
		<div
			data-tauri-drag-region
			className={cn("h-full shrink-0", className)}
			style={{ width: `${width}px` }}
		/>
	);
}
