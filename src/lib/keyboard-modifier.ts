/**
 * Cross-platform keyboard modifier helper.
 *
 * STRICT OS-aware binding: on macOS only Cmd (`event.metaKey`) counts,
 * on Windows / Linux only Ctrl (`event.ctrlKey`) counts. This preserves
 * the EXACT macOS shortcut behavior the app shipped with — Ctrl-based
 * combos that were ignored before (e.g. Ctrl+W, Ctrl+Option+Arrow) stay
 * ignored on macOS. Windows and Linux get Ctrl-based shortcuts that
 * previously didn't work.
 *
 * Rationale: loose binding (accept both) would have expanded the macOS
 * accept set (e.g. Cmd+Ctrl+W would newly trigger session close), which
 * is a behavior change even if no existing macOS convention uses that
 * combo. Strict OS-aware keeps macOS byte-identical.
 */

import { isMac } from "./platform";

/** Returns true if the event carries the host OS's primary modifier:
 *  Cmd on macOS, Ctrl on Windows / Linux. */
export function isPrimaryModifier(
	event: KeyboardEvent | { metaKey: boolean; ctrlKey: boolean },
): boolean {
	return isMac() ? event.metaKey : event.ctrlKey;
}

/** Returns true if the event carries the "wrong" modifier for the host OS:
 *  Ctrl on macOS, Win/Cmd on Windows / Linux. Used in strict shortcut
 *  checks to match the pre-Phase-3 macOS behavior where `event.ctrlKey`
 *  was an explicit reject signal on combos like Cmd+W / Cmd+Option+Arrow. */
export function hasSecondaryModifier(
	event: KeyboardEvent | { metaKey: boolean; ctrlKey: boolean },
): boolean {
	return isMac() ? event.ctrlKey : event.metaKey;
}

/**
 * Returns true when the event is a bare primary modifier + the given key,
 * with NO extra modifiers (shift/alt). Use this for single-modifier shortcuts
 * like Cmd/Ctrl+K where shift/alt would normally pick a different command.
 */
export function isExactPrimaryShortcut(
	event: KeyboardEvent,
	key: string,
): boolean {
	return (
		isPrimaryModifier(event) &&
		!event.shiftKey &&
		!event.altKey &&
		event.key === key
	);
}
