/**
 * One-shot composer prefill queue.
 *
 * Inspector / other surfaces sometimes want to pop a fresh session with
 * the composer pre-loaded with a starter prompt — the user gets to
 * tweak the intro line before sending instead of having an LLM call
 * fire automatically. This module is the rendezvous between "I want to
 * prefill" (queued before / during session creation) and "I just
 * mounted the composer for that session" (synchronously consumes).
 *
 * Shape of a prefill:
 *   - `intro`: short line the user will likely complete in place. The
 *     composer puts the caret at the END of this text, so the user can
 *     start typing immediately ("I want to create a run action that …").
 *   - `body`: long-form instructions to the agent. Rendered on a new
 *     line below the intro, with a leading horizontal-rule separator
 *     so the agent can visually tell apart user intent vs. fixed
 *     guidance the UI inserted on the user's behalf.
 *
 * Lifetime: prefills sit in an in-memory map. Consume is one-shot, so
 * re-mounting the same session (e.g. tab switch) won't keep re-applying
 * a stale prefill. The map never crosses page reloads — that's fine,
 * the user dispatches this from a live click.
 */
export type ComposerPrefill = {
	intro: string;
	body: string;
};

const queue = new Map<string, ComposerPrefill>();
const liveListeners = new Map<string, Set<(p: ComposerPrefill) => void>>();

/**
 * Stash a prefill for `sessionId`. If the composer for this session is
 * already mounted (listener registered), deliver immediately AND skip
 * the queue — otherwise the late-arriving consume would double-apply.
 */
export function enqueueComposerPrefill(
	sessionId: string,
	prefill: ComposerPrefill,
): void {
	const subs = liveListeners.get(sessionId);
	if (subs && subs.size > 0) {
		for (const sub of subs) {
			try {
				sub(prefill);
			} catch (error) {
				console.error("[helmor] composer prefill subscriber threw", error);
			}
		}
		return;
	}
	queue.set(sessionId, prefill);
}

/**
 * Pop the pending prefill for `sessionId`, if any. Called from the
 * composer's mount effect. Returns `null` when nothing is queued.
 */
export function consumeComposerPrefill(
	sessionId: string,
): ComposerPrefill | null {
	const entry = queue.get(sessionId);
	if (entry) queue.delete(sessionId);
	return entry ?? null;
}

/**
 * Subscribe a live composer instance to incoming prefills for its
 * `sessionId`. Used so a prefill dispatched WHILE the composer is
 * already mounted (e.g. user clicks Create while staying on the same
 * session) lands without waiting for a remount.
 */
export function subscribeComposerPrefill(
	sessionId: string,
	listener: (prefill: ComposerPrefill) => void,
): () => void {
	let set = liveListeners.get(sessionId);
	if (!set) {
		set = new Set();
		liveListeners.set(sessionId, set);
	}
	set.add(listener);
	return () => {
		const current = liveListeners.get(sessionId);
		if (!current) return;
		current.delete(listener);
		if (current.size === 0) liveListeners.delete(sessionId);
	};
}

/** Test-only — clears every queued prefill and listener. */
export function __resetComposerPrefillForTests(): void {
	queue.clear();
	liveListeners.clear();
}
