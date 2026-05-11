// Hover-zoom state machine for the inspector tabs panel. Owns:
//   - the three flags that drive the CSS-transitionable expansion
//     (`isHoverExpanded`), the discrete presentation flag that masks the
//     overflow / z-index / data-tabs-zoomed markers (`isZoomPresented`),
//     and the gaussian blur pulse that hides xterm's canvas re-fit
//     artefacts (`isContentBlurred`).
//   - the four mouse-driven event handlers (`onBodyMouseEnter`,
//     `onBodyMouseDown`, `onContainerMouseLeave`,
//     `onTabContextMenuOpenChange`) plus the container-enter ref hook
//     so the parent JSX can keep its data-locality.
//   - the FitAddon suspend/release coordination so each xterm re-fits
//     exactly once after the transition settles, and the
//     text-selection guard that prevents the panel from collapsing
//     while the user is mid-drag.
import { useCallback, useEffect, useRef, useState } from "react";
import { suspendTerminalFit } from "@/components/terminal-output";
import {
	TABS_BLUR_HOLD_UNTIL_MS,
	TABS_HOVER_ACTIVATION_MS,
	TABS_HOVER_TRANSITION_MS,
} from "../layout";

export type HoverZoomController = {
	isHoverExpanded: boolean;
	isZoomPresented: boolean;
	isContentBlurred: boolean;
	onBodyMouseEnter(): void;
	onBodyMouseDown(): void;
	onContainerMouseEnter(): void;
	onContainerMouseLeave(): void;
	onTabContextMenuOpenChange(open: boolean): void;
};

export function useHoverZoom({
	open,
	canHoverExpand,
}: {
	open: boolean;
	canHoverExpand: boolean;
}): HoverZoomController {
	// `isHoverExpanded` drives the CSS-transitionable properties (width /
	// height / box-shadow). Flipping it to `false` immediately starts the
	// shrink animation.
	const [isHoverExpanded, setIsHoverExpanded] = useState(false);
	// `isZoomPresented` drives the properties the browser CANNOT transition
	// (z-index, the `data-tabs-zoomed` flag, the border-t for the top
	// edge). Stays `true` for the full duration of BOTH expand and
	// collapse so the zoomed visual identity stays consistent while the
	// size is changing.
	const [isZoomPresented, setIsZoomPresented] = useState(false);
	// Short-lived flag that applies a gaussian blur to the inner
	// header+body while the panel is mid-transition. Masks the frames
	// where xterm's canvas is being GPU-scaled and then re-fit.
	const [isContentBlurred, setIsContentBlurred] = useState(false);

	const hoverTimerRef = useRef<number | null>(null);
	const presentationClearTimerRef = useRef<number | null>(null);
	const blurClearTimerRef = useRef<number | null>(null);
	const pointerInsideContainerRef = useRef(false);
	// Tracks whether the user is actively selecting text. When true,
	// prevents the panel from collapsing on mouse-leave so text selection
	// can extend beyond the container boundary without interruption.
	const isSelectingRef = useRef(false);
	// Right-click menu portal renders outside the container, so mouseleave
	// fires the moment the cursor crosses into a menu item. Hold the zoom
	// open until the menu closes, then re-check the pointer.
	const isTabContextMenuOpenRef = useRef(false);
	// Holds the outstanding `suspendTerminalFit()` release while the CSS
	// width/height transition is running, plus the timer that will
	// release it and trigger the final fit.
	const terminalFitReleaseRef = useRef<(() => void) | null>(null);
	const fitReleaseTimerRef = useRef<number | null>(null);

	const clearHoverTimer = useCallback(() => {
		if (hoverTimerRef.current !== null) {
			window.clearTimeout(hoverTimerRef.current);
			hoverTimerRef.current = null;
		}
	}, []);

	const clearPresentationClearTimer = useCallback(() => {
		if (presentationClearTimerRef.current !== null) {
			window.clearTimeout(presentationClearTimerRef.current);
			presentationClearTimerRef.current = null;
		}
	}, []);

	const clearBlurTimer = useCallback(() => {
		if (blurClearTimerRef.current !== null) {
			window.clearTimeout(blurClearTimerRef.current);
			blurClearTimerRef.current = null;
		}
	}, []);

	// Run a quick fade-in → hold → fade-out blur over the inner content
	// during the transition. Fires on both expand and collapse because
	// the canvas artefacts and the xterm re-fit flash happen in both
	// directions. Calling this while a pulse is already underway just
	// extends the hold window.
	const triggerContentBlurPulse = useCallback(() => {
		clearBlurTimer();
		setIsContentBlurred(true);
		blurClearTimerRef.current = window.setTimeout(() => {
			blurClearTimerRef.current = null;
			setIsContentBlurred(false);
		}, TABS_BLUR_HOLD_UNTIL_MS);
	}, [clearBlurTimer]);

	const releaseTerminalFitLock = useCallback(() => {
		if (fitReleaseTimerRef.current !== null) {
			window.clearTimeout(fitReleaseTimerRef.current);
			fitReleaseTimerRef.current = null;
		}
		if (terminalFitReleaseRef.current) {
			terminalFitReleaseRef.current();
			terminalFitReleaseRef.current = null;
		}
	}, []);

	// Pause every mounted `TerminalOutput`'s FitAddon for the duration
	// of the CSS transition. Without this, each xterm re-fits once per
	// animation frame (reflowing its 5000-line scrollback) which stutters
	// the zoom. Calling this while a suspension is already active just
	// extends the release timer.
	const beginZoomAnimation = useCallback(() => {
		if (!terminalFitReleaseRef.current) {
			terminalFitReleaseRef.current = suspendTerminalFit();
		}
		if (fitReleaseTimerRef.current !== null) {
			window.clearTimeout(fitReleaseTimerRef.current);
		}
		fitReleaseTimerRef.current = window.setTimeout(() => {
			fitReleaseTimerRef.current = null;
			if (terminalFitReleaseRef.current) {
				terminalFitReleaseRef.current();
				terminalFitReleaseRef.current = null;
			}
			// A small safety margin beyond the CSS transition so the final
			// fit uses the settled dimensions rather than the last interpolated
			// frame's.
		}, TABS_HOVER_TRANSITION_MS + 50);
	}, []);

	// Drives both the CSS-transitionable properties and the discrete
	// ones. Expanding flips presentation on immediately; collapsing keeps
	// presentation on until the shrink transition has run to completion,
	// so z-index / overflow / border stay consistent with the shrinking
	// box.
	const setZoomTarget = useCallback(
		(target: boolean) => {
			triggerContentBlurPulse();
			if (target) {
				clearPresentationClearTimer();
				setIsZoomPresented(true);
			} else {
				clearPresentationClearTimer();
				presentationClearTimerRef.current = window.setTimeout(() => {
					presentationClearTimerRef.current = null;
					setIsZoomPresented(false);
				}, TABS_HOVER_TRANSITION_MS + 20);
			}
			setIsHoverExpanded(target);
		},
		[clearPresentationClearTimer, triggerContentBlurPulse],
	);

	// Hover trigger is bound to the BODY only (not the header) so moving
	// the cursor across the Setup/Run tabs or the chevron doesn't start a
	// zoom. The 300ms "hover intent" timer still gives the linger-to-
	// engage feel.
	const onBodyMouseEnter = useCallback(() => {
		if (!open || !canHoverExpand) return;
		if (isHoverExpanded) return;
		clearHoverTimer();
		hoverTimerRef.current = window.setTimeout(() => {
			beginZoomAnimation();
			setZoomTarget(true);
			hoverTimerRef.current = null;
		}, TABS_HOVER_ACTIVATION_MS);
	}, [
		beginZoomAnimation,
		canHoverExpand,
		clearHoverTimer,
		isHoverExpanded,
		open,
		setZoomTarget,
	]);

	// Mark the start of a potential text selection. Used to prevent the
	// panel from collapsing while the user is dragging to select text.
	const onBodyMouseDown = useCallback(() => {
		isSelectingRef.current = true;
	}, []);

	const onContainerMouseEnter = useCallback(() => {
		pointerInsideContainerRef.current = true;
	}, []);

	// Un-zoom fires only when the cursor leaves the whole panel (header +
	// body). Moving from body up into the header keeps the zoom alive so
	// the Stop/Rerun action and the tab switcher stay reachable while
	// zoomed. Skip collapsing if the user is actively selecting text.
	const onContainerMouseLeave = useCallback(() => {
		pointerInsideContainerRef.current = false;
		const hadPendingHoverIntent = hoverTimerRef.current !== null;
		clearHoverTimer();
		if (isSelectingRef.current) return;
		if (isTabContextMenuOpenRef.current) return;
		if (hadPendingHoverIntent || (!isHoverExpanded && !isZoomPresented)) {
			return;
		}
		beginZoomAnimation();
		setZoomTarget(false);
	}, [
		beginZoomAnimation,
		clearHoverTimer,
		isHoverExpanded,
		isZoomPresented,
		setZoomTarget,
	]);

	// On close, re-evaluate whether to collapse — the mouseleave that
	// fired while the menu was open was suppressed.
	const onTabContextMenuOpenChange = useCallback(
		(menuOpen: boolean) => {
			isTabContextMenuOpenRef.current = menuOpen;
			if (menuOpen) return;
			if (pointerInsideContainerRef.current) return;
			if (!isHoverExpanded && !isZoomPresented) return;
			beginZoomAnimation();
			setZoomTarget(false);
		},
		[beginZoomAnimation, isHoverExpanded, isZoomPresented, setZoomTarget],
	);

	// When the panel collapses we must drop any pending/active zoom so it
	// doesn't linger over neighbouring sections. Also release any
	// outstanding terminal-fit lock immediately.
	useEffect(() => {
		if (!open) {
			clearHoverTimer();
			clearPresentationClearTimer();
			clearBlurTimer();
			releaseTerminalFitLock();
			setIsHoverExpanded(false);
			setIsZoomPresented(false);
			setIsContentBlurred(false);
		}
	}, [
		clearBlurTimer,
		clearHoverTimer,
		clearPresentationClearTimer,
		open,
		releaseTerminalFitLock,
	]);

	// If the active tab no longer has output worth zooming (e.g. user
	// switched from Run to Setup), force the panel back to its resting
	// size through the normal collapse transition.
	useEffect(() => {
		if (canHoverExpand) return;
		clearHoverTimer();
		if (pointerInsideContainerRef.current) return;
		if (!isHoverExpanded && !isZoomPresented) return;
		beginZoomAnimation();
		setZoomTarget(false);
	}, [
		beginZoomAnimation,
		canHoverExpand,
		clearHoverTimer,
		isHoverExpanded,
		isZoomPresented,
		setZoomTarget,
	]);

	// Clear the selection flag on any mouseup, even if it happens outside
	// the panel. Ensures the collapse-on-leave behaviour resumes after
	// the user finishes a text selection.
	useEffect(() => {
		const handleGlobalMouseUp = () => {
			isSelectingRef.current = false;
		};
		document.addEventListener("mouseup", handleGlobalMouseUp);
		return () => document.removeEventListener("mouseup", handleGlobalMouseUp);
	}, []);

	// Clean up any pending timer on unmount.
	useEffect(() => {
		return () => {
			clearHoverTimer();
			clearPresentationClearTimer();
			clearBlurTimer();
			releaseTerminalFitLock();
		};
	}, [
		clearBlurTimer,
		clearHoverTimer,
		clearPresentationClearTimer,
		releaseTerminalFitLock,
	]);

	return {
		isHoverExpanded,
		isZoomPresented,
		isContentBlurred,
		onBodyMouseEnter,
		onBodyMouseDown,
		onContainerMouseEnter,
		onContainerMouseLeave,
		onTabContextMenuOpenChange,
	};
}
