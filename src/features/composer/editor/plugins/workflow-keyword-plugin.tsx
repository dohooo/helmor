import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { registerLexicalTextEntity } from "@lexical/text";
import { mergeRegister } from "@lexical/utils";
import type { TextNode } from "lexical";
import { useEffect } from "react";
import {
	$createWorkflowKeywordNode,
	WorkflowKeywordNode,
} from "../workflow-keyword-node";

// Whole-word "workflow" / "workflows", case-insensitive. Matching the whole
// word (not substrings like "workflows.yaml") keeps the highlight meaningful.
const WORKFLOW_RE = /\bworkflows?\b/i;

function getWorkflowMatch(text: string): { start: number; end: number } | null {
	const match = WORKFLOW_RE.exec(text);
	if (match === null) return null;
	return { start: match.index, end: match.index + match[0].length };
}

/**
 * Live-highlights the word "workflow" in the composer via Lexical's text-entity
 * helper, which owns the split/merge/cursor mechanics — so the caret never
 * jumps and editing the word behaves like normal text. Styling lives entirely
 * in the `composer-workflow-keyword` CSS class (theme accent + reduced-motion
 * safe shimmer).
 */
export function WorkflowKeywordPlugin(): null {
	const [editor] = useLexicalComposerContext();

	useEffect(() => {
		if (!editor.hasNodes([WorkflowKeywordNode])) {
			return;
		}
		const createNode = (textNode: TextNode): WorkflowKeywordNode =>
			$createWorkflowKeywordNode(textNode.getTextContent());
		return mergeRegister(
			...registerLexicalTextEntity(
				editor,
				getWorkflowMatch,
				WorkflowKeywordNode,
				createNode,
			),
		);
	}, [editor]);

	return null;
}
