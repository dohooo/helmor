import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$createTextNode,
	$getRoot,
	$getSelection,
	$isElementNode,
	$isLineBreakNode,
	$isRangeSelection,
	$isTextNode,
	COMMAND_PRIORITY_HIGH,
	COMMAND_PRIORITY_LOW,
	KEY_BACKSPACE_COMMAND,
	KEY_DOWN_COMMAND,
	type TextNode,
} from "lexical";
import { useEffect } from "react";
import { $isCustomTagBadgeNode } from "../custom-tag-badge-node";
import { $isFileBadgeNode } from "../file-badge-node";
import { $isImageBadgeNode } from "../image-badge-node";
import {
	$createTerminalDirectiveNode,
	$isTerminalDirectiveNode,
	TerminalDirectiveNode,
} from "../terminal-directive-node";

function $isBadgeNode(node: import("lexical").LexicalNode): boolean {
	return (
		$isImageBadgeNode(node) ||
		$isFileBadgeNode(node) ||
		$isCustomTagBadgeNode(node)
	);
}

function $findBangTrigger(): TextNode | null {
	const root = $getRoot();
	if (root.getChildrenSize() !== 1) return null;
	const paragraph = root.getFirstChild();
	if (!$isElementNode(paragraph)) return null;
	const children = paragraph.getChildren();
	if (children.length !== 1) return null;
	const node = children[0];
	if (!$isTextNode(node) || node.getTextContent() !== "!") return null;
	return node;
}

type TerminalDirectiveState = {
	active: boolean;
	emptyAfter: boolean;
};

function $readTerminalDirectiveState(): TerminalDirectiveState {
	const root = $getRoot();
	let active = false;
	let hasMeaningfulContent = false;
	for (const child of root.getChildren()) {
		if ($isTerminalDirectiveNode(child)) {
			active = true;
			continue;
		}
		if (!$isElementNode(child)) {
			if ($isBadgeNode(child)) hasMeaningfulContent = true;
			if (child.getTextContent().trim()) hasMeaningfulContent = true;
			continue;
		}
		for (const desc of child.getChildren()) {
			if ($isTerminalDirectiveNode(desc)) {
				active = true;
				continue;
			}
			if ($isLineBreakNode(desc)) continue;
			if ($isBadgeNode(desc)) {
				hasMeaningfulContent = true;
				continue;
			}
			if (desc.getTextContent().trim()) {
				hasMeaningfulContent = true;
			}
		}
	}
	return { active, emptyAfter: active && !hasMeaningfulContent };
}

function $findDirectiveDeleteTarget(): {
	directive: TerminalDirectiveNode;
	queryNode: TextNode | null;
	leadingWhitespaceLen: number;
} | null {
	const selection = $getSelection();
	if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
	const anchorNode = selection.anchor.getNode();
	if ($isTerminalDirectiveNode(anchorNode)) {
		return {
			directive: anchorNode,
			queryNode: null,
			leadingWhitespaceLen: 0,
		};
	}
	if (!$isTextNode(anchorNode)) return null;
	const prev = anchorNode.getPreviousSibling();
	if (!$isTerminalDirectiveNode(prev)) return null;
	const text = anchorNode.getTextContent();
	const leadingWhitespaceLen = text.length - text.trimStart().length;
	if (selection.anchor.offset !== 0) return null;
	return {
		directive: prev,
		queryNode: anchorNode,
		leadingWhitespaceLen,
	};
}

export function TerminalDirectivePlugin({
	enabled,
	onDirectiveChange,
}: {
	enabled: boolean;
	onDirectiveChange: (state: TerminalDirectiveState) => void;
}): null {
	const [editor] = useLexicalComposerContext();

	useEffect(() => {
		if (!editor.hasNodes([TerminalDirectiveNode])) return;
		let previous: TerminalDirectiveState = { active: false, emptyAfter: false };
		const emit = (next: TerminalDirectiveState) => {
			if (
				next.active === previous.active &&
				next.emptyAfter === previous.emptyAfter
			) {
				return;
			}
			previous = next;
			onDirectiveChange(next);
		};
		editor.getEditorState().read(() => {
			emit($readTerminalDirectiveState());
		});
		return editor.registerUpdateListener(
			({ editorState, dirtyElements, dirtyLeaves }) => {
				if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
				editorState.read(() => {
					emit($readTerminalDirectiveState());
				});
			},
		);
	}, [editor, onDirectiveChange]);

	useEffect(() => {
		if (!editor.hasNodes([TerminalDirectiveNode])) return;
		return editor.registerCommand<KeyboardEvent>(
			KEY_BACKSPACE_COMMAND,
			(event) => {
				let removed = false;
				editor.update(() => {
					const found = $findDirectiveDeleteTarget();
					if (!found) return;
					found.directive.remove();
					if (found.queryNode) {
						const nextText = found.queryNode
							.getTextContent()
							.slice(found.leadingWhitespaceLen);
						if (nextText) {
							found.queryNode.setTextContent(nextText);
						} else {
							found.queryNode.remove();
						}
					}
					removed = true;
				});
				if (!removed) return false;
				event?.preventDefault();
				queueMicrotask(() =>
					onDirectiveChange({ active: false, emptyAfter: false }),
				);
				return true;
			},
			COMMAND_PRIORITY_LOW,
		);
	}, [editor, onDirectiveChange]);

	useEffect(() => {
		if (!editor.hasNodes([TerminalDirectiveNode])) return;
		return editor.registerCommand<KeyboardEvent>(
			KEY_DOWN_COMMAND,
			(event) => {
				if (event.key !== " " && event.code !== "Space") return false;
				if (!enabled) return false;
				if (event?.isComposing || event?.keyCode === 229) return false;

				let activated = false;
				editor.update(() => {
					const trigger = $findBangTrigger();
					if (!trigger) return;
					const directive = $createTerminalDirectiveNode();
					const trailing = $createTextNode(" ");
					trigger.replace(directive);
					directive.insertAfter(trailing);
					trailing.select(1, 1);
					activated = true;
				});

				if (!activated) return false;
				event?.preventDefault();
				queueMicrotask(() =>
					onDirectiveChange({ active: true, emptyAfter: true }),
				);
				return true;
			},
			COMMAND_PRIORITY_HIGH,
		);
	}, [editor, enabled, onDirectiveChange]);

	return null;
}
