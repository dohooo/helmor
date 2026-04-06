/**
 * Lexical plugin: handle file drag-and-drop via Tauri's drag-drop event.
 *
 * When files are dropped on the window, inserts them into the editor:
 * - Image files → ImageBadgeNode (inline badge)
 * - Other files → TextNode with @path reference
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createTextNode, $getSelection, $isRangeSelection } from "lexical";
import { useEffect } from "react";
import { isImagePath } from "@/components/image-preview";
import { $createImageBadgeNode } from "../image-badge-node";

/** Image extensions for determining how to handle dropped files. */
const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|svg|bmp|ico)$/i;

export function DropFilePlugin() {
	const [editor] = useLexicalComposerContext();

	useEffect(() => {
		let unlisten: (() => void) | null = null;

		// Tauri v2 drag-drop event
		import("@tauri-apps/api/event")
			.then(({ listen }) => {
				listen<{ paths: string[] }>("tauri://drag-drop", (event) => {
					const paths = event.payload.paths;
					if (!paths || paths.length === 0) return;

					editor.update(() => {
						const selection = $getSelection();
						if (!$isRangeSelection(selection)) {
							// Focus the editor and get a fresh selection
							editor.focus();
							return;
						}

						for (const filePath of paths) {
							if (IMAGE_EXTENSIONS.test(filePath) || isImagePath(filePath)) {
								selection.insertNodes([$createImageBadgeNode(filePath)]);
							} else {
								// Non-image files: insert as @path text reference
								selection.insertNodes([$createTextNode(`@${filePath} `)]);
							}
						}
					});
				}).then((fn) => {
					unlisten = fn;
				});
			})
			.catch(() => {
				// Not in Tauri environment — drag-drop not available
			});

		return () => {
			unlisten?.();
		};
	}, [editor]);

	return null;
}
