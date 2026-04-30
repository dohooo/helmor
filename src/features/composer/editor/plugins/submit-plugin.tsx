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
 * (`[cmdk-item]`) inside any live typeahead popup wrapper, marked with
 * `data-typeahead-popup`. We cannot key off Lexical's anchor div class
 * anymore — the popup now portals into the composer root (so `bottom-full`
 * aligns to the input's top edge instead of the caret), and Lexical's
 * anchor div sits empty on `document.body`. The slash popup also renders
 * a state row (loading/error/empty) inside the same popup using a plain
 * div — that should NOT block Enter from submitting, because there's
 * nothing for the user to select.
 *
 * IME guard: when a CJK IME (Chinese pinyin / Japanese kana / Korean
 * Hangul) is active and the user presses Enter to confirm a candidate
 * from the IME suggestion popup, the browser fires a `keydown` for
 * that Enter with `event.isComposing === true`, and Safari/legacy
 * paths additionally use `event.keyCode === 229`. Lexical's own
 * keydown handler bails on `editor.isComposing()`, but Chrome fires
 * `compositionend` BEFORE the final keydown — so by the time we get
 * here Lexical's flag is already cleared and we'd accidentally submit
 * a half-typed message. Guarding on `isComposing` / `keyCode === 229`
 * is the canonical fix.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { COMMAND_PRIORITY_HIGH, KEY_ENTER_COMMAND } from "lexical";
import { useEffect } from "react";
import { normalizeShortcutEvent } from "@/features/shortcuts/format";

const TYPEAHEAD_SELECTABLE_SELECTOR = "[data-typeahead-popup] [cmdk-item]";

function isTypeaheadSelectable(): boolean {
	if (typeof document === "undefined") return false;
	return document.querySelector(TYPEAHEAD_SELECTABLE_SELECTOR) !== null;
}

export function SubmitPlugin({
	onSubmit,
	onSubmitOpposite,
	toggleHotkey,
	disabled,
}: {
	onSubmit: () => void;
	/** Called when the toggle hotkey fires — submits with the opposite
	 *  follow-up behavior (queue ↔ steer) for this single message. */
	onSubmitOpposite?: () => void;
	/** The customized "send with opposite follow-up" hotkey, normalized
	 *  via `normalizeShortcutEvent` (e.g. "Mod+Enter"). Only honored here
	 *  when the hotkey involves Enter — non-Enter hotkeys are caught by
	 *  the composer wrapper's keydown-capture handler. */
	toggleHotkey?: string | null;
	disabled: boolean;
}) {
	const [editor] = useLexicalComposerContext();

	useEffect(() => {
		return editor.registerCommand(
			KEY_ENTER_COMMAND,
			(event) => {
				if (event?.isComposing || event?.keyCode === 229) return false; // IME confirm — let the browser process it
				if (isTypeaheadSelectable()) return false; // let typeahead select

				// Customized toggle hotkey (e.g. ⌘Enter) — submit with the
				// opposite follow-up behavior for this message only. Checked
				// before the Shift+Enter newline guard so a user-configured
				// toggle on Shift+Enter wins over newline.
				if (event && toggleHotkey && onSubmitOpposite) {
					const eventHotkey = normalizeShortcutEvent(event);
					if (eventHotkey === toggleHotkey) {
						event.preventDefault();
						if (!disabled) onSubmitOpposite();
						return true;
					}
				}

				if (event?.shiftKey) return false; // let Lexical handle newline
				event?.preventDefault();
				if (!disabled) onSubmit();
				return true;
			},
			COMMAND_PRIORITY_HIGH,
		);
	}, [editor, onSubmit, onSubmitOpposite, toggleHotkey, disabled]);

	return null;
}
