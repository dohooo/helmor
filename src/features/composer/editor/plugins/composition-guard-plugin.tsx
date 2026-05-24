import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$createParagraphNode,
	$createTextNode,
	$getNearestNodeFromDOMNode,
	$getRoot,
	$isTextNode,
	$setCompositionKey,
} from "lexical";
import { useEffect, useRef } from "react";

const PURE_PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

type StripResult = {
	domTextNode: Text;
	replacedEnd: number;
};

function isAbandonedImeAsciiBuffer(data: string): boolean {
	return PURE_PRINTABLE_ASCII.test(data) && data.includes(" ");
}

function placeDomSelectionAtEnd(textNode: Node, offset: number) {
	const ownerDocument = textNode.ownerDocument;
	const win = ownerDocument?.defaultView;
	const sel = win?.getSelection();
	if (!sel || !ownerDocument) return;
	const range = ownerDocument.createRange();
	range.setStart(textNode, offset);
	range.setEnd(textNode, offset);
	sel.removeAllRanges();
	sel.addRange(range);
}

function stripImeSegmentationSpaces(
	root: Node,
	target: string,
	replacement: string,
): StripResult | null {
	if (root.nodeType === Node.TEXT_NODE) {
		const textNode = root as Text;
		const text = textNode.textContent;
		if (text?.includes(target)) {
			const matchStart = text.indexOf(target);
			const nextText = text
				.replace(target, replacement)
				.replace(/\u00A0+/g, "");
			const replacedEnd = matchStart + replacement.length;
			textNode.textContent = nextText;
			placeDomSelectionAtEnd(textNode, replacedEnd);
			return {
				domTextNode: textNode,
				replacedEnd,
			};
		}
		return null;
	}
	for (const child of Array.from(root.childNodes)) {
		const result = stripImeSegmentationSpaces(child, target, replacement);
		if (result) return result;
	}
	return null;
}

export function CompositionGuardPlugin() {
	const [editor] = useLexicalComposerContext();
	const stripResultRef = useRef<StripResult | null>(null);

	useEffect(() => {
		// After the DOM strip runs in capture phase, push the same change
		// into the Lexical model and clear the composition key so a
		// subsequent reconcile won't resurrect the stripped buffer.
		// Intentionally NOT touching focus here — any blur/refocus races
		// the OS IME candidate popup's dismiss animation and leaves a
		// visible blank frame.
		const syncStrippedResultToModel = () => {
			const stripResult = stripResultRef.current;
			if (!stripResult) return;
			stripResultRef.current = null;
			editor.update(() => {
				$setCompositionKey(null);
				const domText =
					stripResult.domTextNode.textContent?.replace(/\u00A0/g, "") ?? "";
				const lexicalNode = $getNearestNodeFromDOMNode(stripResult.domTextNode);
				if ($isTextNode(lexicalNode)) {
					if (lexicalNode.getTextContent() !== domText) {
						lexicalNode.setTextContent(domText);
					}
					const offset = Math.min(
						stripResult.replacedEnd,
						lexicalNode.getTextContentSize(),
					);
					lexicalNode.select(offset, offset);
					return;
				}

				const root = $getRoot();
				const currentText = root.getTextContent().replace(/\u00A0/g, "");
				if (!currentText && domText) {
					root.clear();
					const paragraph = $createParagraphNode();
					const textNode = $createTextNode(domText);
					paragraph.append(textNode);
					root.append(paragraph);
					const offset = Math.min(
						stripResult.replacedEnd,
						textNode.getTextContentSize(),
					);
					textNode.select(offset, offset);
					return;
				}

				const lastDescendant = root.getLastDescendant();
				if (!$isTextNode(lastDescendant)) return;
				const size = lastDescendant.getTextContentSize();
				lastDescendant.select(size, size);
			});
		};

		const clearCompositionKey = () => {
			queueMicrotask(() => {
				editor.update(() => {
					$setCompositionKey(null);
				});
			});
		};

		const finalizeInterruptedComposition = (event: Event) => {
			const ce = event as CompositionEvent;
			const root = editor.getRootElement();
			if (!root) return;
			const data = ce.data;
			if (!data) {
				clearCompositionKey();
				return;
			}
			// Mixed-script commits (CJK followed by a space and Latin text)
			// contain real spaces — hand those to Lexical unchanged.
			if (!isAbandonedImeAsciiBuffer(data)) {
				clearCompositionKey();
				return;
			}
			const stripped = data.replace(/\s+/g, "");
			const stripResult = stripImeSegmentationSpaces(root, data, stripped);
			if (!stripResult) {
				clearCompositionKey();
				return;
			}
			stripResultRef.current = stripResult;
			queueMicrotask(syncStrippedResultToModel);
		};

		const unregisterRoot = editor.registerRootListener(
			(rootElement, prevRootElement) => {
				if (prevRootElement) {
					prevRootElement.removeEventListener(
						"compositionend",
						finalizeInterruptedComposition,
						true,
					);
					prevRootElement.removeEventListener(
						"compositioncancel",
						finalizeInterruptedComposition,
						true,
					);
				}
				if (rootElement) {
					rootElement.addEventListener(
						"compositionend",
						finalizeInterruptedComposition,
						true,
					);
					rootElement.addEventListener(
						"compositioncancel",
						finalizeInterruptedComposition,
						true,
					);
				}
			},
		);

		return () => {
			const root = editor.getRootElement();
			if (root) {
				root.removeEventListener(
					"compositionend",
					finalizeInterruptedComposition,
					true,
				);
				root.removeEventListener(
					"compositioncancel",
					finalizeInterruptedComposition,
					true,
				);
			}
			unregisterRoot();
		};
	}, [editor]);

	return null;
}
