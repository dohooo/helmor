/**
 * Lexical plugin: track whether editor has meaningful content
 * (text or image badges) for controlling the send button state.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, $isElementNode } from "lexical";
import { useEffect } from "react";
import { $isCustomTagBadgeNode } from "../custom-tag-badge-node";
import { $isFileBadgeNode } from "../file-badge-node";
import { $isImageBadgeNode } from "../image-badge-node";
import { $isTerminalDirectiveNode } from "../terminal-directive-node";

function $isBadgeNode(node: import("lexical").LexicalNode): boolean {
	return (
		$isImageBadgeNode(node) ||
		$isFileBadgeNode(node) ||
		$isCustomTagBadgeNode(node)
	);
}

function $hasContent(): boolean {
	const root = $getRoot();
	for (const child of root.getChildren()) {
		if ($isElementNode(child)) {
			for (const desc of child.getChildren()) {
				if ($isTerminalDirectiveNode(desc)) continue;
				if (desc.getTextContent().trim()) return true;
				if ($isBadgeNode(desc)) return true;
			}
		} else if (
			!$isTerminalDirectiveNode(child) &&
			child.getTextContent().trim()
		) {
			return true;
		} else if ($isBadgeNode(child)) {
			return true;
		}
	}
	return false;
}

export function HasContentPlugin({
	onChange,
}: {
	onChange: (hasContent: boolean) => void;
}) {
	const [editor] = useLexicalComposerContext();

	useEffect(() => {
		return editor.registerUpdateListener(
			({ editorState, dirtyElements, dirtyLeaves }) => {
				// Skip selection-only updates (clicks, arrow keys): they can't
				// change whether the editor has content, so re-running the
				// full-tree $hasContent() walk on every caret move is wasted
				// work. Same guard AutoResizePlugin uses. The emitted boolean is
				// unchanged — content edits always dirty an element or leaf.
				if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
				editorState.read(() => {
					onChange($hasContent());
				});
			},
		);
	}, [editor, onChange]);

	return null;
}
