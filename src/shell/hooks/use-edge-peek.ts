import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Hover-to-peek state for the edge drawers (left sidebar / right inspector)
 * in mini-window mode. The drawer stays mounted the whole time; the returned
 * `open` flag only toggles the CSS classes that drive the slide + fade, so the
 * browser animates BOTH the entrance and the exit off the same transition.
 *
 * Open is immediate (snappy reveal). Close runs after a short delay so pointer
 * jitter at the drawer's edge — or a momentary slip past its boundary — doesn't
 * slam it shut mid-reveal. Re-entering before the delay elapses cancels the
 * close, giving the drawer simple hover-intent hysteresis.
 */
export function useEdgePeek(closeDelayMs = 120) {
	const [open, setOpen] = useState(false);
	const closeTimerRef = useRef<number | null>(null);

	const cancelPendingClose = useCallback(() => {
		if (closeTimerRef.current !== null) {
			window.clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	}, []);

	// Drop any in-flight close timer when the pane unmounts.
	useEffect(() => cancelPendingClose, [cancelPendingClose]);

	const onPointerEnter = useCallback(() => {
		cancelPendingClose();
		setOpen(true);
	}, [cancelPendingClose]);

	const onPointerLeave = useCallback(() => {
		cancelPendingClose();
		closeTimerRef.current = window.setTimeout(() => {
			closeTimerRef.current = null;
			setOpen(false);
		}, closeDelayMs);
	}, [cancelPendingClose, closeDelayMs]);

	const peekHandlers = useMemo(
		() => ({ onPointerEnter, onPointerLeave }),
		[onPointerEnter, onPointerLeave],
	);

	return { open, peekHandlers };
}
