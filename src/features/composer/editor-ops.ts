import type { TextNode } from "lexical";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	$isElementNode,
	$isTextNode,
} from "lexical";
import { $createCustomTagBadgeNode } from "@/features/composer/editor/custom-tag-badge-node";
import { $createFileBadgeNode } from "@/features/composer/editor/file-badge-node";
import { $createImageBadgeNode } from "@/features/composer/editor/image-badge-node";
import type {
	ComposerCustomTag,
	ComposerInsertItem,
} from "@/lib/composer-insert";

export type DraftEntry = {
	text: string;
	images: string[];
	files: string[];
	customTags: ComposerCustomTag[];
};

export const draftCache = new Map<string, DraftEntry>();

export function $setEditorContent(
	draft: string,
	images: string[],
	files: string[],
	customTags: ComposerCustomTag[],
) {
	const root = $getRoot();
	root.clear();
	const paragraph = $createParagraphNode();
	if (draft) {
		paragraph.append($createTextNode(draft));
	}
	for (const path of images) {
		if (draft || paragraph.getChildrenSize() > 0) {
			paragraph.append($createTextNode(" "));
		}
		paragraph.append($createImageBadgeNode(path));
	}
	for (const path of files) {
		if (draft || paragraph.getChildrenSize() > 0) {
			paragraph.append($createTextNode(" "));
		}
		paragraph.append($createFileBadgeNode(path));
	}
	for (const customTag of customTags) {
		if (draft || paragraph.getChildrenSize() > 0) {
			paragraph.append($createTextNode(" "));
		}
		paragraph.append($createCustomTagBadgeNode(customTag));
	}
	root.append(paragraph);
}

function $getComposerAppendTarget() {
	const root = $getRoot();
	const lastChild = root.getLastChild();
	if ($isElementNode(lastChild)) {
		return lastChild;
	}

	const paragraph = $createParagraphNode();
	root.append(paragraph);
	return paragraph;
}

function $ensureComposerInlineSeparator() {
	const paragraph = $getComposerAppendTarget();
	const lastChild = paragraph.getLastChild();
	if (!lastChild) {
		return;
	}

	if ($isTextNode(lastChild)) {
		const text = lastChild.getTextContent();
		if (text.endsWith(" ") || text.endsWith("\n")) {
			return;
		}
		paragraph.append($createTextNode(" "));
		return;
	}

	paragraph.append($createTextNode(" "));
}

export function $appendComposerInsertItems(items: ComposerInsertItem[]) {
	let selectionTarget: TextNode | null = null;
	let lastInsertedInlineBadge = false;

	for (const item of items) {
		if (item.kind === "text") {
			if (!item.text) continue;
			const paragraph = $getComposerAppendTarget();
			const lastChild = paragraph.getLastChild();
			if (
				lastChild &&
				(!$isTextNode(lastChild) ||
					(lastChild.getTextContent() &&
						!lastChild.getTextContent().endsWith(" ") &&
						!lastChild.getTextContent().endsWith("\n") &&
						!item.text.startsWith(" ") &&
						!item.text.startsWith("\n")))
			) {
				paragraph.append($createTextNode(" "));
			}
			selectionTarget = $createTextNode(item.text);
			paragraph.append(selectionTarget);
			lastInsertedInlineBadge = false;
			continue;
		}

		$ensureComposerInlineSeparator();
		const paragraph = $getComposerAppendTarget();
		if (item.kind === "file") {
			paragraph.append($createFileBadgeNode(item.path));
		} else if (item.kind === "image") {
			paragraph.append($createImageBadgeNode(item.path));
		} else {
			paragraph.append(
				$createCustomTagBadgeNode({
					id: item.key ?? crypto.randomUUID(),
					label: item.label,
					submitText: item.submitText,
					preview: item.preview ?? null,
				}),
			);
		}
		selectionTarget = null;
		lastInsertedInlineBadge = true;
	}

	if (lastInsertedInlineBadge) {
		const paragraph = $getComposerAppendTarget();
		selectionTarget = $createTextNode(" ");
		paragraph.append(selectionTarget);
	}

	if (selectionTarget) {
		const offset = selectionTarget.getTextContentSize();
		selectionTarget.select(offset, offset);
	}
}
