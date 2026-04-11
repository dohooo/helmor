/**
 * Lexical plugin: Enter to submit, Shift+Enter for newline.
 *
 * Important: when a typeahead popup (slash command or @-mention file picker)
 * has at least one selectable item we MUST let Enter fall through to the
 * typeahead's own selection handler instead of submitting the message.
 * Lexical registers the typeahead Enter handler at `COMMAND_PRIORITY_LOW`;
 * this plugin runs at HIGH, so we have to actively bail out by returning
 * `false` when a selection is in flight.
 *
 * We detect "menu has selectable items" by looking for a cmdk *item*
 * (`[cmdk-item]`) inside either typeahead anchor div, NOT just the cmdk
 * root. The slash popup also renders a state row (loading/error/empty)
 * inside the same root using a plain div — that should NOT block Enter
 * from submitting, because there's nothing for the user to select.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { COMMAND_PRIORITY_HIGH, KEY_ENTER_COMMAND } from "lexical";
import { useEffect } from "react";

const TYPEAHEAD_SELECTABLE_SELECTOR =
	".slash-command-anchor [cmdk-item], .file-mention-anchor [cmdk-item]";

function isTypeaheadSelectable(): boolean {
	if (typeof document === "undefined") return false;
	return document.querySelector(TYPEAHEAD_SELECTABLE_SELECTOR) !== null;
}

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
				if (isTypeaheadSelectable()) return false; // let typeahead select
				event?.preventDefault();
				if (!disabled) onSubmit();
				return true;
			},
			COMMAND_PRIORITY_HIGH,
		);
	}, [editor, onSubmit, disabled]);

	return null;
}
