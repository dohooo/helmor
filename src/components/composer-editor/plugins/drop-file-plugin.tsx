/**
 * Lexical plugin: handle file drag-and-drop via Tauri's drag-drop event.
 *
 * Inserts dropped files into the editor:
 * - Image files → ImageBadgeNode
 * - Other files → FileBadgeNode
 *
 * Also blocks the native browser drop to prevent duplicate insertion.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	$isElementNode,
	COMMAND_PRIORITY_CRITICAL,
	DROP_COMMAND,
} from "lexical";
import { useEffect } from "react";
import { $createFileBadgeNode } from "../file-badge-node";
import { $createImageBadgeNode } from "../image-badge-node";

const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|ico)$/i;

export function DropFilePlugin() {
	const [editor] = useLexicalComposerContext();

	useEffect(() => {
		// Block native browser drop so PlainTextPlugin doesn't also insert content
		const unregisterDrop = editor.registerCommand(
			DROP_COMMAND,
			(event) => {
				// Prevent native drop — Tauri's drag-drop event handles it
				event.preventDefault();
				return true;
			},
			COMMAND_PRIORITY_CRITICAL,
		);

		let unlisten: (() => void) | null = null;

		import("@tauri-apps/api/event")
			.then(({ listen }) => {
				listen<{ paths: string[] }>("tauri://drag-drop", (event) => {
					const paths = event.payload.paths;
					if (!paths || paths.length === 0) return;

					editor.update(() => {
						const root = $getRoot();
						let lastChild = root.getLastChild();
						if (!lastChild || !$isElementNode(lastChild)) {
							lastChild = $createParagraphNode();
							root.append(lastChild);
						}
						const paragraph = lastChild as import("lexical").ElementNode;

						for (const filePath of paths) {
							if (IMAGE_EXT_RE.test(filePath)) {
								paragraph.append($createImageBadgeNode(filePath));
							} else {
								paragraph.append($createFileBadgeNode(filePath));
							}
						}

						// Trailing space + select so cursor lands after badges
						const spacer = $createTextNode(" ");
						paragraph.append(spacer);
						spacer.select(1, 1);
					});
				}).then((fn) => {
					unlisten = fn;
				});
			})
			.catch(() => {
				// Not in Tauri environment
			});

		return () => {
			unregisterDrop();
			unlisten?.();
		};
	}, [editor]);

	return null;
}
