import type { TouchEvent } from "react";
import { useMemo, useRef } from "react";

type Args = {
	/** Which screen edge the gesture starts from. */
	side: "left" | "right";
	/** Inward travel (px) required before the drawer is pulled open. */
	threshold?: number;
	onOpen: () => void;
};

/**
 * Edge-swipe-to-open for the touch drawers. Returned handlers attach to a thin
 * catcher strip pinned to the screen edge: a finger that lands on the strip and
 * drags inward past `threshold` pulls the drawer out, mirroring the native
 * mobile drawer gesture. Gestures that are mostly vertical are ignored so the
 * page keeps scrolling, and each touch fires `onOpen` at most once.
 *
 * Note: iOS Safari and Android Chrome reserve the very edge for their own
 * back/forward swipe, so the strip is best-effort — pair it with the scrim tap
 * for a reliable dismiss.
 */
export function useEdgeSwipe({ side, threshold = 44, onOpen }: Args) {
	const startRef = useRef<{ x: number; y: number } | null>(null);
	const firedRef = useRef(false);

	return useMemo(() => {
		const onTouchStart = (event: TouchEvent) => {
			const touch = event.touches[0];
			if (!touch) return;
			startRef.current = { x: touch.clientX, y: touch.clientY };
			firedRef.current = false;
		};
		const onTouchMove = (event: TouchEvent) => {
			const start = startRef.current;
			const touch = event.touches[0];
			if (!start || !touch || firedRef.current) return;
			const dx = touch.clientX - start.x;
			const dy = touch.clientY - start.y;
			// Mostly-vertical drag → leave it to the scroller.
			if (Math.abs(dx) <= Math.abs(dy)) return;
			const inward = side === "left" ? dx : -dx;
			if (inward > threshold) {
				firedRef.current = true;
				onOpen();
			}
		};
		const onTouchEnd = () => {
			startRef.current = null;
		};
		return { onTouchStart, onTouchMove, onTouchEnd };
	}, [side, threshold, onOpen]);
}
