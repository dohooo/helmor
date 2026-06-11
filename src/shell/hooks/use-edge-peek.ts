import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * True when the primary pointer is coarse (touch). Read synchronously on the
 * first render so a touch device never flashes the mouse-only affordance, then
 * kept live via the media-query `change` event — attaching a trackpad to an
 * iPad flips this back to false and restores the hover behaviour. Client-only
 * (Tauri webview, no SSR); the `matchMedia` guard also covers jsdom in tests.
 */
function useCoarsePointer(): boolean {
	const [coarse, setCoarse] = useState(
		() =>
			typeof window !== "undefined" &&
			typeof window.matchMedia === "function" &&
			window.matchMedia("(pointer: coarse)").matches,
	);
	useEffect(() => {
		if (
			typeof window === "undefined" ||
			typeof window.matchMedia !== "function"
		)
			return;
		const mql = window.matchMedia("(pointer: coarse)");
		const update = () => setCoarse(mql.matches);
		update();
		mql.addEventListener("change", update);
		return () => mql.removeEventListener("change", update);
	}, []);
	return coarse;
}

/**
 * Open/close state for the edge drawers (left sidebar / right inspector) in
 * mini-window mode. The drawer stays mounted the whole time; the returned
 * `open` flag only toggles the CSS classes that drive the slide + fade, so the
 * browser animates BOTH the entrance and the exit off the same transition.
 *
 * The interaction model is chosen by pointer type, not viewport width:
 *
 * - Fine pointer (mouse/trackpad): hover-to-peek via `peekHandlers`. Open is
 *   immediate (snappy reveal); close runs after a short delay so pointer jitter
 *   at the drawer's edge doesn't slam it shut mid-reveal. Re-entering before the
 *   delay cancels the close — simple hover-intent hysteresis.
 * - Coarse pointer (touch): there is no hover, so `peekHandlers` is empty and
 *   the drawer is opened with `openNow` (driven by an edge-swipe gesture — see
 *   `useEdgeSwipe`) and dismissed with `close` (tap the scrim). Attaching the
 *   hover handlers here would misfire, because a tap emits pointerenter→
 *   pointerleave and would flicker the drawer.
 */
export function useEdgePeek(closeDelayMs = 120) {
	const [open, setOpen] = useState(false);
	const coarse = useCoarsePointer();
	const closeTimerRef = useRef<number | null>(null);

	const cancelPendingClose = useCallback(() => {
		if (closeTimerRef.current !== null) {
			window.clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	}, []);

	// Drop any in-flight close timer when the pane unmounts.
	useEffect(() => cancelPendingClose, [cancelPendingClose]);

	// Never leave a drawer stuck open when the pointer modality changes (e.g. an
	// iPad gains a trackpad) — the affordance that opened it just disappeared.
	useEffect(() => {
		cancelPendingClose();
		setOpen(false);
	}, [coarse, cancelPendingClose]);

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

	const openNow = useCallback(() => {
		cancelPendingClose();
		setOpen(true);
	}, [cancelPendingClose]);

	const close = useCallback(() => {
		cancelPendingClose();
		setOpen(false);
	}, [cancelPendingClose]);

	const peekHandlers = useMemo(
		() => (coarse ? {} : { onPointerEnter, onPointerLeave }),
		[coarse, onPointerEnter, onPointerLeave],
	);

	return { open, coarse, peekHandlers, openNow, close };
}
