import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { registerLexicalTextEntity } from "@lexical/text";
import { mergeRegister } from "@lexical/utils";
import type { TextNode } from "lexical";
import { useEffect } from "react";
import {
	$createShimmerKeywordNode,
	ShimmerKeywordNode,
} from "../shimmer-keyword-node";

/**
 * Live-highlights one or more "magic" keywords in the composer with the shimmer
 * treatment (styling lives in the `composer-shimmer-keyword` CSS class — theme
 * accent + reduced-motion-safe shimmer), signalling that a special mode will
 * engage as the user types. Lexical's text-entity helper owns the
 * split/merge/cursor mechanics, so the caret never jumps and the keyword stays
 * real editable text.
 *
 * `keywords` are whole-word regex fragments (e.g. `"workflows?"`,
 * `"ultrathink"`), matched case-insensitively at word boundaries so substrings
 * like `workflows.yaml` don't light up.
 */
export function ShimmerKeywordPlugin({
	keywords,
}: {
	keywords: readonly string[];
}): null {
	const [editor] = useLexicalComposerContext();
	// Stable across renders even if `keywords` is an inline array literal.
	const pattern = keywords.join("|");

	useEffect(() => {
		if (!editor.hasNodes([ShimmerKeywordNode]) || pattern.length === 0) {
			return;
		}
		const re = new RegExp(`\\b(?:${pattern})\\b`, "i");
		const getMatch = (text: string): { start: number; end: number } | null => {
			const match = re.exec(text);
			if (match === null) return null;
			return { start: match.index, end: match.index + match[0].length };
		};
		const createNode = (textNode: TextNode): ShimmerKeywordNode =>
			$createShimmerKeywordNode(textNode.getTextContent());
		return mergeRegister(
			...registerLexicalTextEntity(
				editor,
				getMatch,
				ShimmerKeywordNode,
				createNode,
			),
		);
	}, [editor, pattern]);

	return null;
}
