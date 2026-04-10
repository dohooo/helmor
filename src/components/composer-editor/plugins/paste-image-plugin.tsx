/**
 * Lexical plugin: intercept paste to handle:
 * 1. Clipboard image data (e.g. screenshot Cmd+Shift+4) → save to temp file → ImageBadgeNode
 * 2. Text image paths (e.g. /Users/x/screenshot.png) → ImageBadgeNode
 * 3. Large plain text/code payloads → CustomTagBadgeNode with hover preview
 *
 * Uses CRITICAL priority to run before PlainTextPlugin's own paste handler.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$createLineBreakNode,
	$createParagraphNode,
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
import { buildComposerPreviewInsertItem } from "@/lib/composer-insert";
import { $createCustomTagBadgeNode } from "../custom-tag-badge-node";
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

/** Append a node at the end of the last paragraph and move cursor after it. */
function $appendToEnd(...nodes: import("lexical").LexicalNode[]) {
	const root = $getRoot();
	let lastChild = root.getLastChild();
	if (!lastChild || !$isElementNode(lastChild)) {
		lastChild = $createParagraphNode();
		root.append(lastChild);
	}
	const paragraph = lastChild as import("lexical").ElementNode;
	for (const node of nodes) {
		paragraph.append(node);
	}
	// Append a trailing space so cursor lands after the badge
	const spacer = $createTextNode(" ");
	paragraph.append(spacer);
	spacer.select(1, 1);
}

function getClipboardData(event: unknown) {
	if (!event || typeof event !== "object" || !("clipboardData" in event)) {
		return null;
	}

	return (
		(
			event as {
				clipboardData?: {
					files?: File[] | FileList;
					getData?: (format: string) => string;
				} | null;
			}
		).clipboardData ?? null
	);
}

export function PasteImagePlugin() {
	const [editor] = useLexicalComposerContext();

	useEffect(() => {
		return editor.registerCommand(
			PASTE_COMMAND,
			(event) => {
				const clipboardData = getClipboardData(event);
				if (!clipboardData) return false;

				// --- Case 1: Clipboard contains image file(s) (screenshot paste) ---
				const imageFiles: File[] = [];
				for (const file of Array.from(clipboardData.files ?? [])) {
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
				const text = clipboardData.getData?.("text/plain") ?? "";
				if (!text) return false;

				const lines = text.split("\n");
				const hasImages = lines.some((line) => isImagePath(line.trim()));
				if (hasImages) {
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
				}

				// --- Case 3: Clipboard contains large plain text/code ---
				const previewInsertItem = buildComposerPreviewInsertItem({
					content: text,
				});
				if (!previewInsertItem) {
					return false;
				}

				event.preventDefault();

				editor.update(() => {
					const selection = $getSelection();
					const badgeNode = $createCustomTagBadgeNode({
						id: previewInsertItem.key ?? crypto.randomUUID(),
						label: previewInsertItem.label,
						submitText: previewInsertItem.submitText,
						preview: previewInsertItem.preview ?? null,
					});
					const spacer = $createTextNode(" ");

					if ($isRangeSelection(selection)) {
						selection.insertNodes([badgeNode, spacer]);
						return;
					}

					$appendToEnd(badgeNode);
				});

				return true;
			},
			COMMAND_PRIORITY_CRITICAL,
		);
	}, [editor]);

	return null;
}
