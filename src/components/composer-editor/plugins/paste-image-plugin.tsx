/**
 * Lexical plugin: intercept paste to detect image paths and
 * insert ImageBadgeNode inline.
 *
 * Uses CRITICAL priority to run before PlainTextPlugin's own
 * paste handler.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$createLineBreakNode,
	$createTextNode,
	$getSelection,
	$isRangeSelection,
	COMMAND_PRIORITY_CRITICAL,
	PASTE_COMMAND,
} from "lexical";
import { useEffect } from "react";
import { isImagePath } from "@/components/image-preview";
import { $createImageBadgeNode } from "../image-badge-node";

export function PasteImagePlugin() {
	const [editor] = useLexicalComposerContext();

	useEffect(() => {
		return editor.registerCommand(
			PASTE_COMMAND,
			(event) => {
				// PASTE_COMMAND can receive ClipboardEvent, InputEvent, or KeyboardEvent.
				// Only ClipboardEvent has clipboardData.
				if (!(event instanceof ClipboardEvent)) return false;

				const text = event.clipboardData?.getData("text/plain");
				if (!text) return false;

				const lines = text.split("\n");
				const hasImages = lines.some((line) => isImagePath(line.trim()));
				if (!hasImages) return false; // let PlainTextPlugin handle normal text

				event.preventDefault();

				editor.update(() => {
					const selection = $getSelection();
					if (!$isRangeSelection(selection)) return;

					for (let i = 0; i < lines.length; i++) {
						const line = lines[i].trim();
						if (isImagePath(line)) {
							const node = $createImageBadgeNode(line);
							selection.insertNodes([node]);
						} else if (line) {
							const textNode = $createTextNode(line);
							selection.insertNodes([textNode]);
						}
						// Line break between lines (not after the last)
						if (i < lines.length - 1 && (line || i === 0)) {
							selection.insertNodes([$createLineBreakNode()]);
						}
					}
				});

				return true;
			},
			COMMAND_PRIORITY_CRITICAL,
		);
	}, [editor]);

	return null;
}
