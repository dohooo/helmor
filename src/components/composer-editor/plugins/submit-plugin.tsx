/**
 * Lexical plugin: Enter to submit, Shift+Enter for newline.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { COMMAND_PRIORITY_HIGH, KEY_ENTER_COMMAND } from "lexical";
import { useEffect } from "react";

export function SubmitPlugin({
	onSubmit,
	disabled,
}: {
	onSubmit: () => void;
	disabled: boolean;
}) {
	const [editor] = useLexicalComposerContext();

	useEffect(() => {
		return editor.registerCommand(
			KEY_ENTER_COMMAND,
			(event) => {
				if (event?.shiftKey) return false; // let Lexical handle newline
				event?.preventDefault();
				if (!disabled) onSubmit();
				return true;
			},
			COMMAND_PRIORITY_HIGH,
		);
	}, [editor, onSubmit, disabled]);

	return null;
}
