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

function $isBadgeNode(node: import("lexical").LexicalNode): boolean {
	return (
		$isImageBadgeNode(node) ||
		$isFileBadgeNode(node) ||
		$isCustomTagBadgeNode(node)
	);
}

function $hasContent(): boolean {
	const root = $getRoot();
	const text = root.getTextContent().trim();
	if (text) return true;
	for (const child of root.getChildren()) {
		if ($isElementNode(child)) {
			for (const desc of child.getChildren()) {
				if ($isBadgeNode(desc)) return true;
			}
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
		return editor.registerUpdateListener(({ editorState }) => {
			editorState.read(() => {
				onChange($hasContent());
			});
		});
	}, [editor, onChange]);

	return null;
}
