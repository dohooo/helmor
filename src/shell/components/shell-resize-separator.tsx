// Vertical drag handle used between the workspace sidebar / main pane and
// between the main pane / inspector. Identical visuals + behaviour, only
// the side (`"sidebar"` vs `"inspector"`) and offset rules differ.
import {
	type CSSProperties,
	type KeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	useLayoutEffect,
	useRef,
} from "react";
import { useI18n } from "@/lib/i18n";
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
	onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
	onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
};

export function ShellResizeSeparator({
	side,
	collapsed,
	resizing,
	width,
	onPointerDown,
	onKeyDown,
}: Props) {
	const { t } = useI18n();
	// Inline position written via ref so each remount re-applies it; the
	// drag pipeline updates the same node per-frame.
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const node = ref.current;
		if (!node) return;
		if (side === "sidebar") {
			node.style.left = collapsed
				? `${-SIDEBAR_RESIZE_HIT_AREA / 2}px`
				: `${width - SIDEBAR_RESIZE_HIT_AREA / 2}px`;
		} else {
			node.style.right = collapsed
				? `${-SIDEBAR_RESIZE_HIT_AREA}px`
				: `${width - SIDEBAR_RESIZE_HIT_AREA}px`;
		}
	}, [side, collapsed, width]);

	const containerStyle: CSSProperties = {
		width: `${SIDEBAR_RESIZE_HIT_AREA}px`,
	};

	const transitionAxis = side === "sidebar" ? "left" : "right";
	const handleClass =
		side === "sidebar"
			? "absolute inset-y-0 left-1/2 -translate-x-1/2"
			: "absolute inset-y-0 left-0";

	return (
		<div
			ref={ref}
			role="separator"
			tabIndex={collapsed ? -1 : 0}
			aria-hidden={collapsed}
			aria-label={
				side === "sidebar"
					? t("miscResizeSidebar")
					: t("miscResizeInspectorSidebar")
			}
			aria-orientation="vertical"
			aria-valuemin={MIN_SIDEBAR_WIDTH}
			aria-valuemax={MAX_SIDEBAR_WIDTH}
			aria-valuenow={width}
			data-shell-resize={side}
			onPointerDown={onPointerDown}
			onKeyDown={onKeyDown}
			className={cn(
				"group absolute inset-y-0 z-30 cursor-ew-resize touch-none outline-none max-[960px]:hidden",
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
