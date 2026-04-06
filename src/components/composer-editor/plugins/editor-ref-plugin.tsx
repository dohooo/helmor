/**
 * Lexical plugin: expose editor instance to parent via ref.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import type { LexicalEditor } from "lexical";
import { type MutableRefObject, useEffect } from "react";

export function EditorRefPlugin({
	editorRef,
}: {
	editorRef: MutableRefObject<LexicalEditor | null>;
}) {
	const [editor] = useLexicalComposerContext();

	useEffect(() => {
		editorRef.current = editor;
	}, [editor, editorRef]);

	return null;
}
