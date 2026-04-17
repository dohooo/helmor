/**
 * Cross-platform keyboard modifier helper.
 *
 * On macOS the primary modifier is Cmd (`event.metaKey`). On Windows and
 * Linux the convention is Ctrl (`event.ctrlKey`). Accepting both everywhere
 * (loose binding) lets the same shortcut list work on every platform with
 * zero per-component branching. Unix users on a Mac keyboard still get the
 * Cmd behavior they expect; Windows/Linux users get the Ctrl they expect.
 *
 * Cmd+, on Windows is harmless (nothing binds it), so the extra permissive
 * match does not collide with native shortcuts.
 */

/** Returns true if the event carries the "primary" modifier for the host OS. */
export function isPrimaryModifier(
	event: KeyboardEvent | { metaKey: boolean; ctrlKey: boolean },
): boolean {
	return event.metaKey || event.ctrlKey;
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
