/**
 * Lexical plugin: auto-resize editor height based on content,
 * clamped between min and max height.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useEffect } from "react";

export function AutoResizePlugin({
	minHeight = 64,
	maxHeight = 240,
}: {
	minHeight?: number;
	maxHeight?: number;
}) {
	const [editor] = useLexicalComposerContext();

	useEffect(() => {
		return editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
			// Skip selection-only updates (click, arrow keys). Re-measuring on
			// every selection change toggles overflow on/off via height="auto",
			// which clobbers scrollTop and breaks native caret-into-view scroll.
			if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
			const rootEl = editor.getRootElement();
			if (!rootEl) return;
			rootEl.style.height = "auto";
			const next = Math.min(rootEl.scrollHeight, maxHeight);
			rootEl.style.height = `${Math.max(next, minHeight)}px`;
		});
	}, [editor, minHeight, maxHeight]);

	return null;
}
