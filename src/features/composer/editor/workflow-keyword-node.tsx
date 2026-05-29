import {
	$applyNodeReplacement,
	type EditorConfig,
	type LexicalNode,
	type SerializedTextNode,
	TextNode,
} from "lexical";

/**
 * A `TextNode` subclass that styles the literal word "workflow" inline as the
 * user types it, signalling that workflow mode will engage (mirrors the
 * colored/shimmer treatment the Claude Code terminal gives the keyword).
 *
 * It stays REAL editable text — `getTextContent()` returns "workflow", so the
 * sent prompt and persisted draft are unchanged. The split/merge/cursor
 * handling is delegated to `registerLexicalTextEntity` in
 * `workflow-keyword-plugin`, so there is no manual transform and no caret
 * jitter; the only visual change is the `composer-workflow-keyword` class.
 */
export class WorkflowKeywordNode extends TextNode {
	static getType(): string {
		return "workflow-keyword";
	}

	static clone(node: WorkflowKeywordNode): WorkflowKeywordNode {
		return new WorkflowKeywordNode(node.__text, node.__key);
	}

	static importJSON(serialized: SerializedTextNode): WorkflowKeywordNode {
		const node = $createWorkflowKeywordNode(serialized.text);
		node.setFormat(serialized.format);
		node.setDetail(serialized.detail);
		node.setMode(serialized.mode);
		node.setStyle(serialized.style);
		return node;
	}

	exportJSON(): SerializedTextNode {
		return { ...super.exportJSON(), type: "workflow-keyword" };
	}

	createDOM(config: EditorConfig): HTMLElement {
		const dom = super.createDOM(config);
		dom.classList.add("composer-workflow-keyword");
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

export function $createWorkflowKeywordNode(text: string): WorkflowKeywordNode {
	return $applyNodeReplacement(new WorkflowKeywordNode(text));
}

export function $isWorkflowKeywordNode(
	node: LexicalNode | null | undefined,
): node is WorkflowKeywordNode {
	return node instanceof WorkflowKeywordNode;
}
