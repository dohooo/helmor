// Touch drawer layer for the edge panes (left sidebar / right inspector).
// Coarse pointers can't hover the peek rail, so instead of a button we let the
// user pull the drawer out with a native edge-swipe and dismiss it by tapping
// the scrim. Rendered only by the panes when `useEdgePeek` reports a coarse
// pointer; the `max-[960px]:` gates also hide it once the window is wide enough
// that the pane shows as a normal full sidebar (e.g. iPad landscape).
import type { TouchEvent } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type SwipeHandlers = {
	onTouchStart: (event: TouchEvent) => void;
	onTouchMove: (event: TouchEvent) => void;
	onTouchEnd: (event: TouchEvent) => void;
};

type Props = {
	side: "left" | "right";
	open: boolean;
	label: string;
	onClose: () => void;
	swipeHandlers: SwipeHandlers;
};

export function EdgeSwipeLayer({
	side,
	open,
	label,
	onClose,
	swipeHandlers,
}: Props) {
	const { t } = useI18n();
	if (open) {
		// The scrim must sit BELOW the drawer (the pane's aside is z-50) but ABOVE
		// the page content — a middle layer. Rendering it inside the aside breaks
		// both halves of that: the aside is its own stacking context (so a z-40
		// child still paints *over* the z-auto drawer panel and eats its scrolls),
		// and the inspector aside's `contain: layout` traps `position: fixed` inside
		// the 24px rail (so the scrim never covers the screen and taps-to-dismiss go
		// dead). Portalling to <body> escapes both: the scrim lands in the root
		// stacking context at z-40 — under the drawer's z-50, over everything else.
		if (typeof document === "undefined") return null;
		return createPortal(
			<button
				type="button"
				aria-label={`${t("Close")} ${t(label)}`}
				onClick={onClose}
				className="fixed inset-0 z-40 hidden cursor-pointer bg-black/40 max-[960px]:block motion-safe:animate-in motion-safe:fade-in"
				style={{ touchAction: "none" }}
			/>,
			document.body,
		);
	}
	return (
		<div
			aria-hidden
			data-edge-swipe-catcher={side}
			{...swipeHandlers}
			className={cn(
				"absolute inset-y-0 z-50 hidden w-6 max-[960px]:block",
				side === "left" ? "left-0" : "right-0",
			)}
			// Keep vertical page scrolling; claim horizontal drags for the gesture.
			style={{ touchAction: "pan-y" }}
		/>
	);
}
