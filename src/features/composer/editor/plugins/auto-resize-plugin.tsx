/**
 * Lexical plugin: auto-resize editor height based on content,
 * clamped between min and max height. When `shrinkBy` is non-zero, the
 * effective min/max are reduced by that amount and applied as inline
 * `min-height` / `max-height` styles -- inline overrides the Tailwind
 * `min-h-*` / `max-h-*` tokens on `ContentEditable`'s className, so the
 * textarea actually contracts (rather than being clamped back up to its
 * static minimum).
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useEffect } from "react";

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

	useEffect(() => {
		const effectiveMin = Math.max(0, minHeight - shrinkBy);
		const effectiveMax = Math.max(0, maxHeight - shrinkBy);

		const apply = () => {
			const rootEl = editor.getRootElement();
			if (!rootEl) return;
			// Inline min/max win over className-level min-h-*/max-h-* tokens.
			rootEl.style.minHeight = `${effectiveMin}px`;
			rootEl.style.maxHeight = `${effectiveMax}px`;
			rootEl.style.height = "auto";
			const next = Math.min(rootEl.scrollHeight, effectiveMax);
			rootEl.style.height = `${Math.max(next, effectiveMin)}px`;
			rootEl.scrollTop = rootEl.scrollHeight;
		};
		// Run once immediately so changes to `shrinkBy` (e.g. voice toggle
		// with no editor activity) take effect without waiting for typing.
		apply();
		return editor.registerUpdateListener(apply);
	}, [editor, minHeight, maxHeight, shrinkBy]);

	return null;
}
