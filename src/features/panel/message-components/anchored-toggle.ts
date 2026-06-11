// One-shot handshake between the user-message expand/collapse anchor and the
// viewport: the anchor already offsets the scroller for the toggled row's
// height change, so the viewport's height-change compensation must skip that
// one change or the delta double-applies. TTL covers toggles whose reflow
// never reaches the viewport (plain thread, unchanged height).
const ANCHORED_TOGGLE_TTL_MS = 1000;

let pending: { messageId: string; expiresAt: number } | null = null;

export function markAnchoredToggle(messageId: string): void {
	pending = {
		messageId,
		expiresAt: performance.now() + ANCHORED_TOGGLE_TTL_MS,
	};
}

/** Consumes the mark and returns true when `messageId` was just anchor-toggled. */
export function consumeAnchoredToggle(messageId: string | undefined): boolean {
	if (!pending) return false;
	if (performance.now() > pending.expiresAt) {
		pending = null;
		return false;
	}
	if (!messageId || pending.messageId !== messageId) return false;
	pending = null;
	return true;
}

export function resetAnchoredToggle(): void {
	pending = null;
}
