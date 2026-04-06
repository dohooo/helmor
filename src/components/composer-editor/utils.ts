/**
 * Lexical content extraction for the composer editor.
 *
 * $-prefixed functions must be called inside editor.read() or editor.update().
 */

import {
	$getRoot,
	$isElementNode,
	$isLineBreakNode,
	$isTextNode,
} from "lexical";
import { $isFileBadgeNode } from "./file-badge-node";
import { $isImageBadgeNode } from "./image-badge-node";

export function $extractComposerContent(): {
	text: string;
	images: string[];
} {
	const images: string[] = [];
	const textParts: string[] = [];
	const root = $getRoot();

	for (let pi = 0; pi < root.getChildrenSize(); pi++) {
		const paragraph = root.getChildAtIndex(pi);
		if (!paragraph) continue;

		if (pi > 0) textParts.push("\n");

		if ($isElementNode(paragraph)) {
			for (const child of paragraph.getChildren()) {
				if ($isTextNode(child)) {
					textParts.push(child.getTextContent());
				} else if ($isImageBadgeNode(child)) {
					const path = child.getImagePath();
					images.push(path);
					textParts.push(`@${path}`);
				} else if ($isFileBadgeNode(child)) {
					textParts.push(`@${child.getFilePath()}`);
				} else if ($isLineBreakNode(child)) {
					textParts.push("\n");
				}
			}
		} else {
			textParts.push(paragraph.getTextContent());
		}
	}

	return {
		text: textParts
			.join("")
			.replace(/\n{3,}/g, "\n\n")
			.trim(),
		images: [...new Set(images)],
	};
}
