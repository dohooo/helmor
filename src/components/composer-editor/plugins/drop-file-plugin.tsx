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
import { useEffect, useRef } from "react";
import { $createFileBadgeNode } from "../file-badge-node";
import { $createImageBadgeNode } from "../image-badge-node";

const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|ico)$/i;

/** Dedup window (ms) — ignore identical drops within this period. */
const DROP_DEDUP_MS = 500;

export function DropFilePlugin() {
	const [editor] = useLexicalComposerContext();
	const unlistenRef = useRef<(() => void) | null>(null);
	const cancelledRef = useRef(false);
	const lastDropRef = useRef<{ key: string; ts: number }>({ key: "", ts: 0 });

	useEffect(() => {
		cancelledRef.current = false;

		// Block native browser drop so PlainTextPlugin doesn't also insert content
		const unregisterDrop = editor.registerCommand(
			DROP_COMMAND,
			(event) => {
				event.preventDefault();
				return true;
			},
			COMMAND_PRIORITY_CRITICAL,
		);

		// Clean up any stale Tauri listener from a previous effect run
		unlistenRef.current?.();
		unlistenRef.current = null;

		import("@tauri-apps/api/event")
			.then(({ listen }) => {
				if (cancelledRef.current) return; // effect was cleaned up

				listen<{ paths: string[] }>("tauri://drag-drop", (event) => {
					const paths = event.payload.paths;
					if (!paths || paths.length === 0) return;

					// Dedup: ignore if same paths within DROP_DEDUP_MS
					const key = paths.join("|");
					const now = Date.now();
					if (
						key === lastDropRef.current.key &&
						now - lastDropRef.current.ts < DROP_DEDUP_MS
					) {
						return;
					}
					lastDropRef.current = { key, ts: now };

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

						const spacer = $createTextNode(" ");
						paragraph.append(spacer);
						spacer.select(1, 1);
					});
				}).then((fn) => {
					if (cancelledRef.current) {
						fn(); // already cleaned up, immediately unlisten
					} else {
						unlistenRef.current = fn;
					}
				});
			})
			.catch(() => {
				// Not in Tauri environment
			});

		return () => {
			cancelledRef.current = true;
			unregisterDrop();
			unlistenRef.current?.();
			unlistenRef.current = null;
		};
	}, [editor]);

	return null;
}
