/**
 * Lexical plugin: track whether editor has meaningful content
 * (text or image badges) for controlling the send button state.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, $isElementNode } from "lexical";
import { useEffect } from "react";
import { $isImageBadgeNode } from "../image-badge-node";

function $hasContent(): boolean {
	const root = $getRoot();
	const text = root.getTextContent().trim();
	if (text) return true;
	// Check for image badge nodes
	for (const child of root.getChildren()) {
		if ($isElementNode(child)) {
			for (const desc of child.getChildren()) {
				if ($isImageBadgeNode(desc)) return true;
			}
		} else if ($isImageBadgeNode(child)) {
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
		return editor.registerUpdateListener(({ editorState }) => {
			editorState.read(() => {
				onChange($hasContent());
			});
		});
	}, [editor, onChange]);

	return null;
}
