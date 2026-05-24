/**
 * Lexical plugin: auto-resize editor height based on content, clamped
 * between min and max height. When `shrinkBy` is non-zero, the effective
 * min/max are reduced by that amount.
 *
 * The plugin keeps inline `min-height` / `max-height` permanently loose
 * (0 / none) and enforces the real `[effectiveMin, effectiveMax]` bounds
 * by clamping the explicit `height` value it writes. Why: if inline
 * min-height jumps from 24 -> 64 when voice mode turns off, the browser
 * immediately clamps the rendered height to >= 64, snapping the element
 * from its 24 px voice-mode size to 64 px and bypassing any CSS height
 * transition. With min-height pinned at 0, the explicit height value is
 * the only thing the browser uses for layout, so transitioning `height`
 * 24 -> 64 plays its full animation in both directions.
 *
 * The Tailwind `min-h-[64px]` / `max-h-[240px]` tokens on ContentEditable
 * still serve as the pre-mount fallback: between mount and the first
 * useEffect commit they keep the editor at a sensible size.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useEffect, useRef } from "react";

export function AutoResizePlugin({
	minHeight = 64,
	maxHeight = 240,
	shrinkBy = 0,
}: {
	minHeight?: number;
	maxHeight?: number;
	/** Pixels removed from both `minHeight` and `maxHeight`. Used by voice
	 *  mode to shrink the textarea (and therefore the whole composer) by a
	 *  fixed amount without deforming any element. */
	shrinkBy?: number;
}) {
	const [editor] = useLexicalComposerContext();
	const didApplyInitialHeightRef = useRef(false);

	useEffect(() => {
		const effectiveMin = Math.max(0, minHeight - shrinkBy);
		const effectiveMax = Math.max(0, maxHeight - shrinkBy);

		// Frame-level guard so we don't double-schedule the rAF when an
		// editor update lands while one is already pending.
		let rafId: number | null = null;
		const apply = () => {
			const rootEl = editor.getRootElement();
			if (!rootEl) return;
			// Loose inline min/max so the browser's clamp never interrupts the
			// `height` transition mid-animation. The explicit height below
			// enforces [effectiveMin, effectiveMax] itself.
			rootEl.style.minHeight = "0px";
			rootEl.style.maxHeight = "none";

			// Measure natural content height with transitions disabled and
			// a synchronous height-restore, so the browser doesn't think the
			// element ever passed through `auto` (CSS can't interpolate
			// numeric <-> auto and would abort the `height` transition).
			rootEl.style.transition = "none";
			const prevHeight = rootEl.style.height || `${rootEl.offsetHeight}px`;
			rootEl.style.height = "auto";
			const naturalScroll = rootEl.scrollHeight;
			rootEl.style.height = prevHeight;
			// Force layout commit of the no-transition + restored-prevHeight
			// state. Without this the browser may collapse the entire JS
			// task into a single style-change event and never see prevHeight
			// as the transition's "from" value.
			void rootEl.offsetHeight;

			const next = Math.min(naturalScroll, effectiveMax);
			const target = `${Math.max(next, effectiveMin)}px`;

			if (!didApplyInitialHeightRef.current) {
				didApplyInitialHeightRef.current = true;
				rootEl.style.height = target;
				rootEl.scrollTop = rootEl.scrollHeight;
				void rootEl.offsetHeight;
				rootEl.style.transition = "";
				return;
			}

			// Defer the target assignment one rAF so the no-transition state
			// becomes the committed baseline. The next frame restores the
			// transition AND assigns the target in the same micro-step --
			// the browser sees one numeric -> numeric `height` change, with
			// transition active, and animates it.
			if (rafId != null) cancelAnimationFrame(rafId);
			rafId = requestAnimationFrame(() => {
				rafId = null;
				rootEl.style.transition = "";
				rootEl.style.height = target;
				rootEl.scrollTop = rootEl.scrollHeight;
			});
		};
		// Run once immediately so changes to `shrinkBy` (e.g. voice toggle
		// with no editor activity) take effect without waiting for typing.
		apply();
		const unsubscribe = editor.registerUpdateListener(
			({ dirtyElements, dirtyLeaves }) => {
				// Skip selection-only updates (click, arrow keys). Re-measuring
				// on every selection change toggles overflow on/off via
				// height="auto", which clobbers scrollTop and breaks native
				// caret-into-view scroll. (From origin/main.)
				if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
				apply();
			},
		);
		return () => {
			if (rafId != null) cancelAnimationFrame(rafId);
			unsubscribe();
		};
	}, [editor, minHeight, maxHeight, shrinkBy]);

	return null;
}
