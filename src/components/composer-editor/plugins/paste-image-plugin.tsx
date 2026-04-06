/**
 * Lexical plugin: intercept paste to handle:
 * 1. Clipboard image data (e.g. screenshot Cmd+Shift+4) → save to temp file → ImageBadgeNode
 * 2. Text image paths (e.g. /Users/x/screenshot.png) → ImageBadgeNode
 *
 * Uses CRITICAL priority to run before PlainTextPlugin's own paste handler.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$createLineBreakNode,
	$createTextNode,
	$getRoot,
	$getSelection,
	$isElementNode,
	$isRangeSelection,
	COMMAND_PRIORITY_CRITICAL,
	PASTE_COMMAND,
} from "lexical";
import { useEffect } from "react";
import { isImagePath } from "@/components/image-preview";
import { savePastedImage } from "@/lib/api";
import { $createImageBadgeNode } from "../image-badge-node";

/** Read a File/Blob as a base64 string (without the data: prefix). */
function readFileAsBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result as string;
			const base64 = result.split(",")[1] ?? result;
			resolve(base64);
		};
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

/** Append a node at the end of the last paragraph (or create one). */
function $appendToEnd(...nodes: import("lexical").LexicalNode[]) {
	const root = $getRoot();
	let lastChild = root.getLastChild();
	if (!lastChild || !$isElementNode(lastChild)) {
		const { $createParagraphNode } = require("lexical");
		lastChild = $createParagraphNode();
		root.append(lastChild);
	}
	for (const node of nodes) {
		(lastChild as import("lexical").ElementNode).append(node);
	}
}

export function PasteImagePlugin() {
	const [editor] = useLexicalComposerContext();

	useEffect(() => {
		return editor.registerCommand(
			PASTE_COMMAND,
			(event) => {
				if (!(event instanceof ClipboardEvent)) return false;

				const clipboardData = event.clipboardData;
				if (!clipboardData) return false;

				// --- Case 1: Clipboard contains image file(s) (screenshot paste) ---
				const imageFiles: File[] = [];
				for (const file of clipboardData.files) {
					if (file.type.startsWith("image/")) {
						imageFiles.push(file);
					}
				}

				if (imageFiles.length > 0) {
					event.preventDefault();

					for (const file of imageFiles) {
						readFileAsBase64(file)
							.then((base64) => savePastedImage(base64, file.type))
							.then((savedPath) => {
								editor.update(() => {
									// Use $appendToEnd instead of selection-based insert,
									// because the selection may be stale after async operations.
									$appendToEnd($createImageBadgeNode(savedPath));
								});
							})
							.catch((err) => {
								console.error("[PasteImagePlugin] Failed to save image:", err);
							});
					}

					return true;
				}

				// --- Case 2: Clipboard contains text with image paths ---
				const text = clipboardData.getData("text/plain");
				if (!text) return false;

				const lines = text.split("\n");
				const hasImages = lines.some((line) => isImagePath(line.trim()));
				if (!hasImages) return false;

				event.preventDefault();

				editor.update(() => {
					const selection = $getSelection();
					if (!$isRangeSelection(selection)) return;

					for (let i = 0; i < lines.length; i++) {
						const line = lines[i].trim();
						if (isImagePath(line)) {
							selection.insertNodes([$createImageBadgeNode(line)]);
						} else if (line) {
							selection.insertNodes([$createTextNode(line)]);
						}
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
