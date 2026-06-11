import {
	$applyNodeReplacement,
	type EditorConfig,
	type LexicalNode,
	type SerializedTextNode,
	TextNode,
} from "lexical";

/**
 * A `TextNode` subclass that gives a "magic" keyword the inline shimmer
 * treatment as the user types it (mirrors the colored/shimmer cue the Claude
 * Code terminal gives such keywords), signalling that a special mode will
 * engage. It is keyword-agnostic — `ShimmerKeywordPlugin` decides which words
 * become this node; the node only applies the `composer-shimmer-keyword` class.
 *
 * It stays REAL editable text — `getTextContent()` returns the literal word, so
 * the sent prompt and persisted draft are unchanged. Split/merge/cursor
 * handling is delegated to `registerLexicalTextEntity` in the plugin, so there
 * is no manual transform and no caret jitter.
 */
export class ShimmerKeywordNode extends TextNode {
	static getType(): string {
		return "shimmer-keyword";
	}

	static clone(node: ShimmerKeywordNode): ShimmerKeywordNode {
		return new ShimmerKeywordNode(node.__text, node.__key);
	}

	static importJSON(serialized: SerializedTextNode): ShimmerKeywordNode {
		const node = $createShimmerKeywordNode(serialized.text);
		node.setFormat(serialized.format);
		node.setDetail(serialized.detail);
		node.setMode(serialized.mode);
		node.setStyle(serialized.style);
		return node;
	}

	exportJSON(): SerializedTextNode {
		return { ...super.exportJSON(), type: "shimmer-keyword" };
	}

	createDOM(config: EditorConfig): HTMLElement {
		const dom = super.createDOM(config);
		dom.classList.add("composer-shimmer-keyword");
		return dom;
	}

	/** Text entity: the helper manages how this node splits/merges. */
	isTextEntity(): true {
		return true;
	}

	/** Keep typing adjacent to the keyword in plain text, not inside it. */
	canInsertTextBefore(): boolean {
		return false;
	}

	canInsertTextAfter(): boolean {
		return false;
	}
}

export function $createShimmerKeywordNode(text: string): ShimmerKeywordNode {
	return $applyNodeReplacement(new ShimmerKeywordNode(text));
}

export function $isShimmerKeywordNode(
	node: LexicalNode | null | undefined,
): node is ShimmerKeywordNode {
	return node instanceof ShimmerKeywordNode;
}
